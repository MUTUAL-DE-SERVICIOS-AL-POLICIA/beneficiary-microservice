import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { CreatePersonDto } from './dto/create-person.dto';
import { UpdatePersonDto } from './dto/update-person.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Person } from './entities/person.entity';
import { PaginationDto } from 'src/common/dtos/pagination.dto';

@Injectable()
export class PersonsService {

  private readonly logger = new Logger('PersonsService');

  constructor(
    @InjectRepository(Person)
    private readonly personRepository: Repository<Person>,
  ){}
  async create(createPersonDto: CreatePersonDto) {

    try {

      const person = this.personRepository.create(createPersonDto);
      await this.personRepository.save( person );
      return person;

    } catch (error) {

      this.handleDBException(error);

    }
  }

  findAll(paginationDto: PaginationDto) {

    const { limit, page } = paginationDto
    const offset = (page - 1) * limit;
    return this.personRepository.find({
      take: limit,
      skip: offset
    })
  }

  async findOne(id: number) {
    const person = await this.personRepository.findOneBy({id});

    if (!person) throw new NotFoundException(`Person with: ${id} not found`);
    
    return person;
  }

  async update(id: number, updatePersonDto: UpdatePersonDto) {

    const person = await this.personRepository.preload({
      id: id,
      ...updatePersonDto
    })

    if (!person) throw new NotFoundException(`Person with: ${id} not found`);

    try {
      await this.personRepository.save( person);
      return person
    } catch (error) {
      this.handleDBException(error)
    }

  }

  async remove(id: number) {
    const person = this.personRepository.findOneBy({id});
    if (person) {
      await this.personRepository.softDelete(id);
      return `This action removes a #${id} person`;
    } else {
      throw new NotFoundException(`Person with: ${id} not found`);
    }
  }

  private handleDBException( error:any ){

    if (error.code === '23505')
      throw new BadRequestException(error.detail);
    this.logger.error(error);
    throw new InternalServerErrorException('Unexecpected Error')


  }
}
